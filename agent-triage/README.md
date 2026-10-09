# Agent Triage Simulator

A multi-agent service desk you can watch, step through and break. Requests come into the fictional
Northwind Health Data Platform. A router agent picks a specialist, the specialist calls tools, and
guardrails, a policy gate and a human reviewer decide what is actually allowed to happen. Every step
shows up in a trace.

**[jkastl.github.io/agent-triage](https://jkastl.github.io/agent-triage/)**

[![Agent Triage tests](https://github.com/jkastl/jkastl.github.io/actions/workflows/agent-triage-tests.yml/badge.svg)](https://github.com/jkastl/jkastl.github.io/actions/workflows/agent-triage-tests.yml)

This is a simulation of the architecture, not a live LLM. Routing and agent "reasoning" are
rule-based, and latency and failures come from a seeded generator, so each scenario plays out the
same way every time. All people, datasets and tickets are made up. Nothing is fetched or sent anywhere.

## Architecture

```
            ┌───────────────┐   ┌───────────┐   ┌──────────────────────┐
request ──► │ input         │──►│ router    │──►│ data access agent    │── lookup_dataset, check_existing_access,
            │ guardrails    │   │ intent +  │   │                      │   check_policy, create_ticket*
            │ PII redaction │   │ confidence│──►│ onboarding agent     │── lookup_user, provision_workspace*,
            │ injection     │   └─────┬─────┘   │                      │   assign_training*
            └──────┬────────┘         │         │ triage agent         │── check_service_status,
                   │ blocked          │ < 0.70  └──────────┬───────────┘   search_known_issues, escalate*
                   ▼                  ▼                    │ * writes
               outcome          human review ◄── needs ─── write gate ──► ticketing (ITSM)
                                (approve/reject)  approval  (re-checks policy)
```

- **Input guardrails** run before any agent sees the text. PII (SSN, MRN, date of birth, email, phone)
  is replaced with placeholders, and only the redacted copy is logged. Text that tries to override
  the agents' instructions is blocked outright; weaker signals are flagged, and every write from a
  flagged request needs approval.
- **Router** scores the request for data access, onboarding, incident or out of scope. Below 0.70
  confidence, a person picks: send it on, or put it in the manual queue.
- **Specialist agents** each own their tools and nothing else. Reads go straight to the tool; writes go
  through the **write gate**, which re-runs the policy engine itself rather than trusting what the agent
  concluded, and enforces read-only, expiring grants and least-privilege starter datasets.
- **Human in the loop:** high-risk writes (identified or limited data, onboarding by someone who isn't
  the manager, anything from a flagged request) pause until you click Approve or Reject.
- **Mock tools** have realistic latency, and scenarios can make them time out or return malformed
  JSON. Calls are validated against the fields they must return, retried with exponential backoff
  (200 ms, 400 ms, plus jitter) up to 3 attempts, and escalated to a person if they never recover.
  Ticket writes carry an idempotency key so a retry can't open a duplicate.

## Scenarios

| # | Scenario | What happens |
|---|---|---|
| 1 | Clean data access request | Policy allows de-identified claims; ticket created automatically |
| 2 | Restricted dataset | Rule R1 denies behavioral health notes, with a reason and where to go instead |
| 3 | Ambiguous request | Router confidence 0.44, so you decide where it goes |
| 4 | Onboarding a new analyst | lookup_user → provision_workspace → assign_training ×2 |
| 5 | Incident matching a known issue | Status check, KB search, fix and link for KI-1042 |
| 6 | Tool timeout | Catalog times out twice, then succeeds on retry 3 |
| 7 | Prompt injection | "Ignore all previous instructions…" is blocked before the router |
| 8 | PII in the ticket | Fake SSN, MRN and phone are redacted at intake |
| 9 | Malformed tool response | Bad JSON from the KB fails validation, then a retry succeeds |
| 10 | High-risk write | Identified EHR data is allowed only with your approval |
| 11 | Out of scope | Travel booking is declined politely, with no tools called |
| 12 | New incident | No known issue and a degraded feed, so it's escalated to on-call as P2 |

You can also edit the text or requester to make your own request. Typed requests get an occasional
random timeout or malformed response, seeded by the text so they still replay the same way.

## Running it

No build step and no dependencies. Open `index.html` in a browser, or serve the repo root and go
to `/agent-triage/`:

```sh
python3 -m http.server
```

Tests use Node's built-in runner (Node 20 or later):

```sh
node --test 'agent-triage/test/*.test.js'
```

They cover the router, every policy rule, the guardrails (including harmless text that must *not*
trip them), the write gate, and every scenario's outcome. They also check that runs are
reproducible event for event, that raw PII never reaches the trace, and that a run paused for
approval can't continue without a decision. A GitHub Action runs them on every push that touches
this folder.

## Layout

```
index.html              page text and structure
style.css               dark theme shared with the other demos, plus the simulator
js/engine/              the simulation; no DOM, loads in the browser and in Node
  rng.js                seeded RNG, seeds from text, token estimate
  data.js               the fictional org: people, datasets, services, known issues
  guardrails.js         PII redaction, injection screening, write gate
  policy.js             ordered attribute-based access rules
  router.js             intent scoring, confidence, entity extraction
  tools.js              the mock tools, malformed responses, response validation
  agents.js             the three specialist agents
  runner.js             the pipeline, tool calls with retry, approvals, metrics
  scenarios.js          the 12 scenarios, as data
js/diagram.js           the architecture diagram (wide and phone layouts)
js/ui.js                controls, playback, trace, metrics, approval card
test/                   node:test suites
```

The engine files are classic scripts that attach to one global, `AT`, so the page works from
`file://` without a bundler and Node can `require()` the same files. `AT.run(request)` is a
generator: each `next()` returns one trace event, and an `approval_request` event waits for
`next('approve')` or `next('reject')`. The UI just pulls events and draws them, so playback speed
never changes what happens.

## Simulated vs. real

| Piece | Here | A real system |
|---|---|---|
| Router | Weighted phrase matching | An LLM classifier measured against a labelled eval set, threshold tuned on real traffic |
| Agents | Scripted plans with a written rationale | Model-planned tool calls inside instructions, a tool allowlist and callbacks |
| Tools | In-memory, seeded latency and faults | Real APIs behind per-tool service accounts, with timeouts and circuit breakers |
| Guardrails | Regexes | A DLP service for PII and a classifier for injection, plus the same deterministic write gate |
| Policy | Eight rules in JavaScript | A policy engine (for example OPA) fed by the identity provider and catalog tags |
| Human review | A button | An approval task in the ITSM, with the session resumed on the answer |
| Observability | The trace panel | OpenTelemetry traces, an append-only audit log, cost and latency budgets |

In Google ADK terms: the router is a coordinator `LlmAgent` with the specialists as `sub_agents`;
tools are Python functions; redaction and injection screening are a `before_model_callback`; the write
gate is a `before_tool_callback`; approvals are a long-running tool whose answer resumes the session.
It would run as a Cloud Run service called by the ITSM's webhook.

## Versioning

The version and date in the footer of `index.html` are **updated by hand**, the same way as the rest
of the site: patch for wording or fixes, minor for a new or changed scenario or a small visual change,
major for a redesign.
