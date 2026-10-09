/* Mock tools: a data catalog, directory, IAM, policy engine, ticketing (ITSM) API, workspace API,
 * training system, knowledge base and status page.
 *
 * Each tool declares what a real function tool would: its owning system, whether it reads or
 * writes, a latency range, and the fields a valid response must have. run() returns a plain
 * object; the runner serializes it and parses it back, so a malformed response fails the same
 * way a bad payload from a real API would. Timeouts and malformed replies are injected by the
 * runner, not here, so these stay simple.
 */
(function (AT) {
  'use strict';

  const D = () => AT.data;

  const TOOLS = {
    // ---- data access agent ----
    lookup_dataset: {
      agent: 'access', kind: 'read', system: 'Data catalog', latency: [140, 380], returns: ['found'],
      run({ dataset_id, query }) {
        const ds = D().datasets;
        const id = dataset_id && ds[dataset_id] ? dataset_id : AT.router.findEntities(String(query || ''), null).datasets[0];
        if (!id) return { found: false, candidates: [] };
        const d = ds[id];
        return { found: true, dataset_id: id, name: d.name, classification: d.classification, steward: d.steward };
      },
    },
    check_existing_access: {
      agent: 'access', kind: 'read', system: 'IAM', latency: [60, 180], returns: ['has_access'],
      run({ user_id, dataset_id }) {
        const has = (D().grants[user_id] || []).includes(dataset_id);
        return { has_access: has, user_id, dataset_id, ...(has ? { granted_via: 'REQ-08812', expires: '2027-01-31' } : {}) };
      },
    },
    check_policy: {
      agent: 'access', kind: 'read', system: 'Policy engine', latency: [40, 110], returns: ['decision', 'rule', 'reason'],
      run({ user_id, dataset_id }) {
        return AT.policy.evaluate(D().people[user_id], D().datasets[dataset_id]);
      },
    },
    create_ticket: {
      agent: 'access', kind: 'write', system: 'ITSM', latency: [320, 720], returns: ['number', 'state'],
      run(args, rand) {
        return {
          number: 'REQ-' + (10400 + Math.floor(rand() * 500)),
          state: args.approved_by ? 'approved_fulfilling' : 'auto_approved_fulfilling',
          fulfillment: 'IAM group membership, expires in ' + args.expires_in_days + ' days',
          idempotency_key: args.idempotency_key,
        };
      },
    },

    // ---- onboarding agent ----
    lookup_user: {
      agent: 'onboard', kind: 'read', system: 'Directory', latency: [80, 200], returns: ['found'],
      run({ name }) {
        const p = Object.values(D().people).find((x) => x.name.toLowerCase() === String(name).toLowerCase());
        if (!p) return { found: false };
        return { found: true, user_id: p.id, name: p.name, role: p.role, team: p.team, status: p.status, start_date: p.startDate || null, manager: p.manager };
      },
    },
    provision_workspace: {
      agent: 'onboard', kind: 'write', system: 'Workspace API', latency: [600, 1200], returns: ['workspace_id', 'status'],
      run({ user_id, template, datasets }) {
        return { workspace_id: `ws-${user_id.split('.')[0]}-${template}`, status: 'ready', template, datasets_attached: datasets };
      },
    },
    assign_training: {
      agent: 'onboard', kind: 'write', system: 'Training system', latency: [150, 350], returns: ['assignment_id'],
      run({ user_id, module, due }, rand) {
        return { assignment_id: 'TRN-' + (5000 + Math.floor(rand() * 900)), user_id, module, due };
      },
    },

    // ---- triage agent ----
    check_service_status: {
      agent: 'triage', kind: 'read', system: 'Status page', latency: [60, 160], returns: ['services'],
      run({ service }) {
        const all = D().services;
        const pick = service && all[service] ? [all[service]] : Object.values(all);
        return { services: pick.map((s) => ({ id: s.id, status: s.status, ...(s.note ? { note: s.note } : {}) })) };
      },
    },
    search_known_issues: {
      agent: 'triage', kind: 'read', system: 'Knowledge base', latency: [160, 420], returns: ['matches'],
      run({ query, service }) {
        const words = new Set(AT.words(query));
        const matches = D().knownIssues.map((ki) => {
          const hit = ki.keywords.filter((k) => words.has(k));
          // Share of the issue's top keywords present, plus a nudge if the service matches.
          const score = Math.min(1, hit.length / Math.min(4, ki.keywords.length) + (service === ki.service ? 0.2 : 0));
          return { id: ki.id, title: ki.title, score: Math.round(score * 100) / 100, matched: hit, url: ki.url, fix: ki.fix };
        }).filter((m) => m.score > 0.2).sort((a, b) => b.score - a.score);
        return { matches };
      },
    },
    escalate: {
      agent: 'triage', kind: 'write', system: 'ITSM', latency: [300, 650], returns: ['number', 'assignment_group'],
      run({ service, severity }, rand) {
        return { number: 'INC-' + (20300 + Math.floor(rand() * 600)), assignment_group: D().onCall[service] || D().onCall.default, severity, state: 'new' };
      },
    },
  };

  // A reply that fails the same way real ones do: a payload cut off mid-stream, or a field the
  // client expects that came back renamed.
  function malformed(tool, good, rand) {
    const json = JSON.stringify(good);
    if (rand() < 0.5) return json.slice(0, Math.max(8, Math.floor(json.length * 0.6)));
    const bad = { ...good };
    const key = tool.returns[0];
    bad[key + '_v2'] = bad[key];
    delete bad[key];
    return JSON.stringify(bad);
  }

  // Parse and check required fields. Returns { ok, value } or { ok: false, error }.
  function validate(tool, raw) {
    let value;
    try { value = JSON.parse(raw); } catch (e) { return { ok: false, error: 'Response is not valid JSON (' + e.message.split('\n')[0] + ')' }; }
    const missing = tool.returns.filter((k) => !(k in value));
    if (missing.length) return { ok: false, error: 'Response missing required field: ' + missing.join(', ') };
    return { ok: true, value };
  }

  AT.tools = { TOOLS, get: (name) => TOOLS[name], malformed, validate };
})(globalThis.AT = globalThis.AT || {});
