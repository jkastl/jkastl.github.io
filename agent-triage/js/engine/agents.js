/* The three specialist agents.
 *
 * Each agent is a generator: it yields trace events as it goes and calls tools through the run
 * context (run.call for reads, run.write for writes, run.think for a model decision). Writes
 * always go through the write gate, which can stop them or ask a person first; the agent can't
 * skip that step because run.write is the only way it has to reach a write tool.
 *
 * An agent returns { outcome, reply }. The reply is what the requester would see on their ticket.
 */
(function (AT) {
  'use strict';

  const D = () => AT.data;
  const DUE = '2026-11-02';

  // ---------------------------------------------------------------- data access
  function* dataAccess(run, route) {
    const A = 'access';
    const user = run.requester;
    const dsId = route.entities.datasets[0];

    yield* run.think(A, 'Plan the request',
      dsId
        ? `Requester names ${dsId}. Plan: confirm it in the catalog, check for an existing grant, ask the policy engine, then open a ticket if allowed.`
        : 'No dataset named outright. Plan: search the catalog with the request text first.',
      { plan: ['lookup_dataset', 'check_existing_access', 'check_policy', 'create_ticket'] });

    const ds = yield* run.call(A, 'lookup_dataset', dsId ? { dataset_id: dsId } : { query: run.text.slice(0, 120) });
    if (!ds.found) {
      yield* run.think(A, 'Dataset not identified', 'Catalog search found nothing that matches. Guessing a dataset would risk granting the wrong thing, so ask the requester instead.');
      return { outcome: 'escalated', reply: "I couldn't tell which dataset you need. A service desk analyst will follow up to confirm the dataset name." };
    }

    const existing = yield* run.call(A, 'check_existing_access', { user_id: user.id, dataset_id: ds.dataset_id });
    if (existing.has_access) {
      yield* run.think(A, 'Already granted', `${user.name} already has read access via ${existing.granted_via}. Nothing to create.`);
      return { outcome: 'resolved', reply: `You already have read access to ${ds.name} (via ${existing.granted_via}, expires ${existing.expires}). No new request needed.` };
    }

    const policy = yield* run.call(A, 'check_policy', { user_id: user.id, dataset_id: ds.dataset_id, purpose: run.subject });
    yield* run.think(A, `Policy says ${policy.decision.replace('_', ' ')}`,
      `${policy.rule}: ${policy.reason}` + (policy.approver ? ` Route the grant to ${policy.approver.name} for a decision.` : ''),
      { decision: policy.decision, rule: policy.rule, ...(policy.approver ? { approver: policy.approver } : {}) });

    if (policy.decision === 'deny') {
      return { outcome: 'denied', reply: `Access to ${ds.name} was not granted. ${policy.reason} If you think this is wrong, reply to this ticket and a data steward will review it.` };
    }

    const w = yield* run.write(A, 'create_ticket', {
      type: 'access_grant', user_id: user.id, dataset_id: ds.dataset_id, access: 'read', expires_in_days: 90,
      policy_rule: policy.rule,
      // Same request, same key: a retried call can't open a second ticket.
      idempotency_key: `${run.requestId}:${ds.dataset_id}:read`,
    });
    if (w.blocked) return { outcome: 'denied', reply: `Access to ${ds.name} was not granted: ${w.gate.reason}` };
    const by = w.approver ? w.approver.name : 'A reviewer';
    if (w.rejected) return { outcome: 'rejected', reply: `${by} declined access to ${ds.name}. They'll add a note to this ticket explaining why.` };
    return {
      outcome: 'resolved',
      reply: `Done. ${w.value.number} grants read access to ${ds.name} for 90 days (rule ${policy.rule}${w.approver ? `, approved by ${w.approver.name}` : ''}). It should show up in your workspace within 15 minutes.`,
    };
  }

  // ---------------------------------------------------------------- onboarding
  function* onboarding(run, route) {
    const A = 'onboard';
    const hireId = route.entities.people[0];
    if (!hireId) {
      yield* run.think(A, 'No new hire named', 'The request reads like onboarding but names nobody in the directory. Asking rather than guessing.');
      return { outcome: 'escalated', reply: 'Who is starting? A service desk analyst will follow up for the new hire\'s name and start date.' };
    }

    const hire = yield* run.call(A, 'lookup_user', { name: D().people[hireId].name });
    if (!hire.found) return { outcome: 'escalated', reply: 'That person isn\'t in the directory yet. HR has to create the record first; a service desk analyst will follow up.' };

    const tpl = D().roleTemplates[hire.role];
    if (!tpl) {
      yield* run.think(A, 'No template for role', `There's no starter template for the ${hire.role} role, so a person should set this up.`);
      return { outcome: 'escalated', reply: `There's no standard setup for the ${hire.role} role. A platform engineer will set this up by hand.` };
    }
    yield* run.think(A, `Use the ${hire.role} template`,
      `${hire.name} is a ${hire.role} on ${hire.team}, starting ${hire.start_date}. The ${hire.role} template gives workspace "${tpl.workspace}", ${tpl.datasets.length} starter datasets (de-identified/internal only) and ${tpl.training.length} training modules.`,
      { template: tpl });

    const ws = yield* run.write(A, 'provision_workspace', { user_id: hire.user_id, template: tpl.workspace, datasets: tpl.datasets });
    if (ws.blocked) return { outcome: 'denied', reply: `Workspace setup was blocked: ${ws.gate.reason}` };
    if (ws.rejected) return { outcome: 'rejected', reply: 'A reviewer declined the workspace setup. They\'ll follow up on this ticket.' };

    const assigned = [];
    for (const module of tpl.training) {
      const t = yield* run.write(A, 'assign_training', { user_id: hire.user_id, module, due: DUE });
      if (t.value) assigned.push(module);
    }
    return {
      outcome: 'resolved',
      reply: `${hire.name} is set up: workspace ${ws.value.workspace_id} is ready with ${tpl.datasets.join(' and ')}, and ${assigned.join(' and ')} are assigned, due ${DUE}. Anything beyond the starter datasets goes through a normal access request.`,
    };
  }

  // ---------------------------------------------------------------- triage
  function* triage(run, route) {
    const A = 'triage';
    const service = route.entities.services[0] || null;
    yield* run.think(A, 'Plan the triage',
      `Service mentioned: ${service || 'none'}. Plan: check service status, search known issues, and escalate if nothing matches well.`,
      { plan: ['check_service_status', 'search_known_issues', 'escalate?'] });

    const status = yield* run.call(A, 'check_service_status', { service });
    const svc = status.services.find((s) => s.id === service);
    const ki = yield* run.call(A, 'search_known_issues', { query: run.text.slice(0, 300), service });
    const best = ki.matches[0];

    if (best && best.score >= 0.6) {
      yield* run.think(A, `Matches ${best.id}`,
        `${best.id} scores ${best.score} (matched ${best.matched.join(', ')}). Above the 0.6 bar, so reply with the fix instead of paging anyone.`,
        { match: best.id, score: best.score });
      return { outcome: 'resolved', reply: `This looks like known issue ${best.id}: ${best.title}. Fix: ${best.fix} Details: ${best.url}`, link: best.url };
    }

    const degraded = svc && svc.status !== 'operational';
    const severity = degraded ? 'P2' : 'P3';
    yield* run.think(A, 'No known issue; escalate',
      (best ? `Best match ${best.id} only scores ${best.score}, below 0.6. ` : 'No known issue matches. ') +
      (degraded ? `${service} is ${svc.status} (${svc.note}), so this is likely live: escalate as ${severity}.` : `Escalate as ${severity} for a person to investigate.`),
      { severity });

    const esc = yield* run.write(A, 'escalate', { service: service || 'unknown', severity, summary: run.text.slice(0, 140) });
    if (!esc.value) return { outcome: 'escalated', reply: 'This needs a person; it has been sent to the service desk queue.' };
    return { outcome: 'escalated', reply: `Escalated to ${esc.value.assignment_group} as ${esc.value.number} (${severity}).${degraded ? ` Status page already shows ${svc.note.toLowerCase()}.` : ''}` };
  }

  AT.agents = {
    data_access: { node: 'access', name: 'Data access agent', run: dataAccess },
    onboarding: { node: 'onboard', name: 'Onboarding agent', run: onboarding },
    incident: { node: 'triage', name: 'Triage agent', run: triage },
  };
})(globalThis.AT = globalThis.AT || {});
