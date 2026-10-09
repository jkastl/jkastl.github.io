/* The runner: takes one request through intake → guardrails → router → specialist → outcome and
 * emits a trace event for every step.
 *
 * AT.run(request) is a generator. Each next() returns the next trace event. When it yields an
 * event of type "approval_request" it stops until the caller passes a decision back with
 * next('approve') or next('reject'). That pause is the human-in-the-loop: the run can't continue
 * without an answer, the same way a real agent session waits on an approval before resuming.
 *
 * Time is simulated. Each step adds its latency to a virtual clock, so the timings in the trace
 * are the same on every run and on any machine.
 */
(function (AT) {
  'use strict';

  AT.CONFIG = {
    confidenceThreshold: 0.7,
    toolTimeoutMs: 1500,
    maxAttempts: 3,
    backoffBaseMs: 200,
    // Only typed-in requests get random faults; scenarios declare theirs so they replay exactly.
    randomTimeoutRate: 0.04,
    randomMalformedRate: 0.03,
    // Wall-clock cost of any step that waits on a person: an approval, or a handoff to a queue
    // or on-call. Agent latency is seconds; this is what dominates time to completion.
    humanStepMs: 3 * 24 * 60 * 60 * 1000,
  };

  AT.OUTCOMES = {
    auto_resolved: { label: 'Auto-resolved', level: 'good' },
    human_approved: { label: 'Human-approved', level: 'good' },
    denied: { label: 'Denied by policy', level: 'bad' },
    rejected: { label: 'Rejected by approver', level: 'bad' },
    escalated: { label: 'Escalated to a person', level: 'warn' },
    blocked: { label: 'Blocked by guardrails', level: 'bad' },
    declined: { label: 'Declined: out of scope', level: 'info' },
  };

  // Rough system-prompt sizes per agent, so token counts grow the way they would for real.
  const PROMPT_TOKENS = { router: 420, access: 610, onboard: 540, triage: 580 };

  const AGENT_NAMES = { access: 'The data access agent', onboard: 'The onboarding agent', triage: 'The triage agent' };

  class ToolFailure extends Error {
    constructor(tool, attempts) {
      super(`${tool} failed after ${attempts} attempts`);
      this.tool = tool;
    }
  }

  class Run {
    constructor(request, opts) {
      this.request = request;
      this.requestId = request.id || 'REQ-LOCAL';
      this.requester = AT.data.people[request.from];
      this.rand = AT.rng(opts.seed ?? AT.hashSeed(request.id || request.text));
      this.faults = Object.fromEntries(Object.entries(request.faults || {}).map(([k, v]) => [k, v.slice()]));
      this.randomFaults = !!opts.randomFaults;
      this.t = 0;
      this.seq = 0;
      this.contextTokens = 0;
      this.humanApproved = false;
      this.suspect = false;
      this.text = '';
      this.subject = '';
    }

    ev(e) {
      return { seq: ++this.seq, t: this.t, level: 'info', ...e };
    }

    nextFault(tool) {
      const planned = this.faults[tool];
      if (planned && planned.length) return planned.shift();
      if (!this.randomFaults) return 'ok';
      const r = this.rand();
      return r < AT.CONFIG.randomTimeoutRate ? 'timeout'
        : r < AT.CONFIG.randomTimeoutRate + AT.CONFIG.randomMalformedRate ? 'malformed' : 'ok';
    }

    // A model call: the agent decides something and says why.
    *think(agent, title, rationale, data) {
      const tin = (PROMPT_TOKENS[agent] || 500) + AT.tokens(this.text) + this.contextTokens;
      const tout = AT.tokens(rationale) + 14;
      const ms = 220 + tout * 14 + Math.round(this.rand() * 160);
      const at = this.t;
      this.t += ms;
      yield { ...this.ev({ type: 'decision', actor: agent, nodes: [agent], title, detail: rationale, data, ms, tokens: { in: tin, out: tout } }), t: at };
    }

    // A tool call with timeout, validation and exponential backoff.
    *call(agent, name, args) {
      const tool = AT.tools.get(name);
      const C = AT.CONFIG;
      const nodes = [agent, 'tool:' + name].concat(tool.system === 'ITSM' ? ['itsm'] : []);
      for (let attempt = 1; attempt <= C.maxAttempts; attempt++) {
        yield this.ev({ type: 'tool_call', actor: agent, nodes, title: `${name}()`, detail: `${tool.system} · ${tool.kind}${attempt > 1 ? ` · attempt ${attempt}` : ''}`, data: { tool: name, args, attempt } });
        const fault = this.nextFault(name);
        if (fault === 'timeout') {
          this.t += C.toolTimeoutMs;
          yield this.ev({ type: 'tool_error', actor: agent, nodes, level: 'bad', title: `${name}: timed out`, detail: `No response within ${C.toolTimeoutMs} ms.`, data: { error: 'DEADLINE_EXCEEDED', timeout_ms: C.toolTimeoutMs, attempt }, ms: C.toolTimeoutMs });
        } else {
          const ms = AT.between(this.rand, tool.latency[0], tool.latency[1]);
          this.t += ms;
          const good = tool.run(args, this.rand);
          const raw = fault === 'malformed' ? AT.tools.malformed(tool, good, this.rand) : JSON.stringify(good);
          const check = AT.tools.validate(tool, raw);
          if (check.ok) {
            this.contextTokens += AT.tokens(raw);
            yield this.ev({ type: 'tool_result', actor: agent, nodes, level: 'good', title: `${name} → ok`, detail: `${ms} ms`, data: check.value, ms });
            return check.value;
          }
          yield this.ev({ type: 'tool_error', actor: agent, nodes, level: 'bad', title: `${name}: malformed response`, detail: check.error, data: { error: 'MALFORMED_RESPONSE', raw: raw.length > 160 ? raw.slice(0, 160) + '…' : raw, attempt }, ms });
        }
        if (attempt < C.maxAttempts) {
          // Exponential backoff with a little seeded jitter so retries from many runs don't line up.
          const wait = C.backoffBaseMs * 2 ** (attempt - 1) + Math.round(this.rand() * 40);
          this.t += wait;
          yield this.ev({ type: 'retry', actor: agent, nodes, level: 'warn', title: `Retry ${name} in ${wait} ms`, detail: `Backoff ${C.backoffBaseMs} × 2^${attempt - 1} plus jitter. Attempt ${attempt + 1} of ${C.maxAttempts}.`, data: { next_attempt: attempt + 1, backoff_ms: wait }, ms: wait });
        }
      }
      throw new ToolFailure(name, C.maxAttempts);
    }

    // Every write goes through the gate first. Returns { value } | { blocked, gate } | { rejected }.
    *write(agent, name, args) {
      let gate = yield* this.gate(name, args);
      if (!gate.allow) return { blocked: true, gate };
      if (gate.needsApproval) {
        const who = gate.approver;
        const ok = yield* this.ask({
          title: who ? `Sent to the dataset owner, ${who.name}` : `Approve ${name}?`,
          question: `${AGENT_NAMES[agent]} wants to run ${name}. Risk: ${gate.risk}. ${gate.reason}`,
          risk: gate.risk, data: { tool: name, args }, approver: who,
          approveLabel: who ? `Approve as ${who.name}` : 'Approve', rejectLabel: 'Reject',
        });
        if (!ok) return { rejected: true, approver: who };
        this.humanApproved = true;
        args = { ...args, approved_by: who ? who.id : 'service_desk_reviewer' };
        // Check again with the approval recorded: the gate, not the agent, decides it counts.
        gate = yield* this.gate(name, args);
        if (!gate.allow || gate.needsApproval) return { blocked: true, gate };
      }
      return { value: yield* this.call(agent, name, args), approver: gate.approver };
    }

    *gate(name, args) {
      const gate = AT.guardrails.writeGate({ tool: name, args, requester: this.requester, suspect: this.suspect });
      this.t += 12;
      const verdict = !gate.allow ? 'blocked' : gate.needsApproval ? 'needs approval' : args.approved_by ? 'approval verified' : 'passed';
      yield this.ev({
        type: 'gate', actor: 'gate', nodes: ['gate'], intervened: !gate.allow || gate.needsApproval,
        level: !gate.allow ? 'bad' : gate.needsApproval ? 'warn' : 'good',
        title: `Write gate: ${verdict} (${name})`,
        detail: gate.reason, data: { tool: name, risk: gate.risk, ...(gate.approver ? { approver: gate.approver } : {}), checks: gate.checks },
      });
      return gate;
    }

    // Pause for a person. The caller resumes the generator with 'approve' or 'reject'.
    // `approver` names the one person who may answer (a dataset owner); otherwise any reviewer.
    *ask({ title, question, risk, data, approver, approveLabel, rejectLabel }) {
      const decision = yield this.ev({ type: 'approval_request', actor: 'human', nodes: ['human'], level: 'warn', title, detail: question, risk, data, approver, approveLabel, rejectLabel });
      if (decision !== 'approve' && decision !== 'reject') throw new Error('approval_request needs next("approve") or next("reject")');
      const ok = decision === 'approve';
      const who = approver ? approver.name : 'Reviewer';
      yield this.ev({
        type: 'approval', actor: 'human', nodes: ['human'], level: ok ? 'good' : 'bad',
        title: `${who} ${ok ? 'approved' : 'rejected'}`,
        detail: 'Time spent waiting on the approver is not counted in latency.',
        data: { decision, approver: approver ? approver.id : 'service_desk_reviewer' },
      });
      return ok;
    }
  }

  function* pipeline(run) {
    const G = AT.guardrails;
    const req = run.request;
    const C = AT.CONFIG;

    yield run.ev({
      type: 'intake', actor: 'intake', nodes: ['intake'], title: 'Request received',
      detail: 'The raw text stays at the edge. Only the redacted copy goes to the agents or into this trace.',
      data: { request_id: run.requestId, channel: req.channel || 'portal', from: req.from, role: run.requester?.role, characters: req.text.length },
    });
    run.t += 20;

    // 1. PII redaction, before any model sees the text.
    const pii = G.redactPII(req.text);
    const subj = G.redactPII(req.subject || '');
    run.text = pii.text;
    run.subject = subj.text;
    run.t += 18;
    yield run.ev({
      type: 'guardrail', actor: 'guardrails', nodes: ['guard'], intervened: pii.count + subj.count > 0,
      level: pii.count ? 'warn' : 'good',
      title: pii.count ? `PII redacted: ${Object.entries(pii.found).map(([k, n]) => `${n} ${k}`).join(', ')}` : 'PII scan: clean',
      detail: pii.count ? 'Agents only ever see the placeholders.' : 'No SSNs, MRNs, dates of birth, emails or phone numbers found.',
      data: { found: pii.found, text_seen_by_agents: pii.text },
    });

    // 2. Prompt-injection screening.
    const inj = G.detectInjection(pii.text);
    run.t += 22;
    yield run.ev({
      type: 'guardrail', actor: 'guardrails', nodes: ['guard'], intervened: inj.verdict !== 'clean',
      level: inj.verdict === 'block' ? 'bad' : inj.verdict === 'flag' ? 'warn' : 'good',
      title: inj.verdict === 'block' ? 'Prompt injection: blocked' : inj.verdict === 'flag' ? 'Prompt injection: suspicious, flagged' : 'Injection screen: clean',
      detail: inj.verdict === 'block' ? 'The request tries to override the agents\' instructions. It never reaches the router.'
        : inj.verdict === 'flag' ? 'Allowed through, but every write it leads to now needs a person to approve it.' : 'No instruction-override patterns found.',
      data: { verdict: inj.verdict, score: inj.score, hits: inj.hits },
    });
    if (inj.verdict === 'block') {
      return { outcome: 'blocked', reply: 'This request was stopped by input screening and passed to the security team. No agent acted on it. If it was a genuine request, please resubmit it without the embedded instructions.' };
    }
    run.suspect = inj.verdict === 'flag';

    // 3. Routing.
    const route = AT.router.classify(pii.text, req.from);
    const label = route.intent.replace(/_/g, ' ');
    yield* run.think('router', `Route: ${label} (${Math.round(route.confidence * 100)}%)`, route.rationale, {
      intent: route.intent, confidence: route.confidence, threshold: C.confidenceThreshold, scores: route.scores, entities: route.entities,
    });

    if (route.intent === 'unknown') {
      return { outcome: 'escalated', reply: "I couldn't work out what this request needs. It's in the service desk's manual queue." };
    }
    if (route.confidence < C.confidenceThreshold) {
      const target = AT.agents[route.intent]?.name || 'a polite decline';
      const ok = yield* run.ask({
        title: 'Low-confidence route',
        question: `The router is ${Math.round(route.confidence * 100)}% sure this is "${label}"; the bar is ${C.confidenceThreshold * 100}%. Send it to ${target}, or to the manual queue?`,
        risk: 'medium', data: { intent: route.intent, confidence: route.confidence, scores: route.scores },
        approveLabel: `Send to ${target}`, rejectLabel: 'Manual queue',
      });
      if (!ok) return { outcome: 'escalated', reply: 'A service desk analyst will pick this up from the manual queue.' };
      run.humanApproved = true;
    }

    if (route.intent === 'out_of_scope') {
      yield* run.think('router', 'Decline politely', 'Outside what the data platform handles. No tools needed; point the requester somewhere useful.');
      return { outcome: 'declined', reply: 'This desk handles data access, onboarding and data platform issues, so I can\'t help with that one. Travel, expenses and IT hardware go through the main employee help portal.' };
    }

    // 4. Specialist.
    const agent = AT.agents[route.intent];
    run.t += 8;
    yield run.ev({ type: 'handoff', actor: 'router', nodes: ['router', agent.node], title: `Handoff to ${agent.name}`, detail: 'The specialist gets the redacted text, the requester\'s identity and the router\'s entities. Nothing else.', data: { to: agent.node, entities: route.entities } });
    try {
      return yield* agent.run(run, route);
    } catch (e) {
      if (!(e instanceof ToolFailure)) throw e;
      yield run.ev({ type: 'decision', actor: agent.node, nodes: [agent.node], level: 'bad', title: 'Giving up on the tool', detail: `${e.message}. Rather than guess, hand the request to a person with the trace attached.` });
      return { outcome: 'escalated', reply: `One of our systems (${e.tool}) isn't responding. A service desk analyst has your request and will finish it by hand.` };
    }
  }

  AT.run = function* (request, opts = {}) {
    const run = new Run(request, opts);
    const result = yield* pipeline(run);
    const outcome = result.outcome === 'resolved' ? (run.humanApproved ? 'human_approved' : 'auto_resolved') : result.outcome;
    yield run.ev({
      type: 'outcome', actor: 'runner', nodes: ['done'], level: AT.OUTCOMES[outcome].level,
      title: AT.OUTCOMES[outcome].label, detail: result.reply,
      // An escalation hands the request to a person to finish, so it counts as a human step.
      data: { outcome, reply_to_requester: result.reply, human_handoff: outcome === 'escalated' },
    });
    return { outcome, reply: result.reply };
  };

  // Totals for the metrics strip, computed from the events so far.
  //   latencyMs     time the system itself spent (simulated clock)
  //   humanSteps    approvals asked for, plus a final handoff to a person
  //   completionMs  what the requester waits: latency plus humanStepMs per human step
  AT.metrics = function (events) {
    const last = events[events.length - 1];
    const done = events.find((e) => e.type === 'outcome');
    const latencyMs = last ? last.t + (last.ms && last.type === 'decision' ? last.ms : 0) : 0;
    const humanSteps = events.filter((e) => e.type === 'approval_request').length + (done?.data.human_handoff ? 1 : 0);
    return {
      latencyMs,
      humanSteps,
      completionMs: latencyMs + humanSteps * AT.CONFIG.humanStepMs,
      toolCalls: events.filter((e) => e.type === 'tool_call').length,
      retries: events.filter((e) => e.type === 'retry').length,
      interventions: events.filter((e) => e.intervened).length,
      tokens: events.reduce((a, e) => a + (e.tokens ? e.tokens.in + e.tokens.out : 0), 0),
      outcome: done ? done.data.outcome : null,
    };
  };

  // Run start to finish with a fixed decision policy. Used by the tests.
  AT.runAll = function (request, { decide = () => 'approve', ...opts } = {}) {
    const it = AT.run(request, opts);
    const events = [];
    let step = it.next();
    while (!step.done) {
      events.push(step.value);
      step = step.value.type === 'approval_request' ? it.next(decide(step.value)) : it.next();
    }
    return { events, result: step.value, metrics: AT.metrics(events) };
  };

  AT.ToolFailure = ToolFailure;
})(globalThis.AT = globalThis.AT || {});
