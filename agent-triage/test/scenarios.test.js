const test = require('node:test');
const assert = require('node:assert/strict');
const AT = require('./load.js');

for (const s of AT.scenarios) {
  test(`scenario "${s.id}" ends ${s.expect.outcome}`, () => {
    const { result, events } = AT.runAll(AT.requestFor(s));
    assert.equal(result.outcome, s.expect.outcome);
    assert.equal(events.at(-1).type, 'outcome');
  });
  if (s.expect.rejected) {
    test(`scenario "${s.id}" ends ${s.expect.rejected} when the reviewer rejects`, () => {
      assert.equal(AT.runAll(AT.requestFor(s), { decide: () => 'reject' }).result.outcome, s.expect.rejected);
    });
  }
}

test('every run is reproducible, event for event', () => {
  for (const s of AT.scenarios) {
    assert.deepEqual(AT.runAll(AT.requestFor(s)).events, AT.runAll(AT.requestFor(s)).events, s.id);
  }
});

test('typed requests with random faults are reproducible too', () => {
  const req = { id: 'x', from: 'theo.nguyen', text: 'need access to the pharmacy fills dataset' };
  assert.deepEqual(AT.runAll(req, { randomFaults: true }).events, AT.runAll(req, { randomFaults: true }).events);
});

test('raw PII never appears in any trace event', () => {
  const s = AT.scenarios.find((x) => x.id === 'pii');
  const trace = JSON.stringify(AT.runAll(AT.requestFor(s)).events);
  for (const secret of ['000-12-3456', '00482913', '555-014-2297']) assert.ok(!trace.includes(secret), secret);
  assert.ok(trace.includes('[SSN]'));
});

test('a blocked injection never reaches the router or any tool', () => {
  const s = AT.scenarios.find((x) => x.id === 'injection');
  const { events } = AT.runAll(AT.requestFor(s));
  assert.ok(!events.some((e) => e.actor === 'router' || e.type === 'tool_call'));
});

test('timeouts retry with exponential backoff, then succeed', () => {
  const s = AT.scenarios.find((x) => x.id === 'timeout-retry');
  const { events, metrics } = AT.runAll(AT.requestFor(s));
  const waits = events.filter((e) => e.type === 'retry').map((e) => e.data.backoff_ms);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 200 && waits[0] < 250, String(waits[0]));
  assert.ok(waits[1] >= 400 && waits[1] < 450, String(waits[1]));
  assert.equal(metrics.retries, 2);
});

test('a tool that never recovers escalates instead of guessing', () => {
  const req = { ...AT.requestFor(AT.scenarios[0]), faults: { lookup_dataset: ['timeout', 'timeout', 'timeout'] } };
  const { result, events } = AT.runAll(req);
  assert.equal(result.outcome, 'escalated');
  assert.ok(!events.some((e) => e.type === 'tool_call' && e.data.tool === 'create_ticket'));
});

test('a run waiting on approval cannot continue without a decision', () => {
  const it = AT.run(AT.requestFor(AT.scenarios.find((x) => x.id === 'high-risk')));
  let step = it.next();
  while (step.value.type !== 'approval_request') step = it.next();
  assert.throws(() => it.next(), /needs next/);
});
