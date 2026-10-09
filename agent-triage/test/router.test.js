const test = require('node:test');
const assert = require('node:assert/strict');
const AT = require('./load.js');

const route = (text, from = 'priya.raman') => AT.router.classify(text, from);
const T = () => AT.CONFIG.confidenceThreshold;

test('clear requests route to the right intent above the threshold', () => {
  const cases = [
    ['I need read access to the de-identified claims data for my analysis.', 'data_access'],
    ['Sam Rivera joins my team on Monday, please get them set up with a workspace.', 'onboarding'],
    ['The dashboard is stale and the refresh keeps failing with an error.', 'incident'],
    ['Can you book a flight and hotel for my conference?', 'out_of_scope'],
  ];
  for (const [text, intent] of cases) {
    const r = route(text, 'lena.ortiz');
    assert.equal(r.intent, intent, text);
    assert.ok(r.confidence >= T(), `${text} → ${r.confidence}`);
  }
});

test('mixed signals land below the threshold', () => {
  const r = route("The numbers look weird and I think I need the claims table for my report.");
  assert.ok(r.confidence < T(), `confidence ${r.confidence}`);
});

test('no signal at all is "unknown" with zero confidence', () => {
  const r = route('hello there');
  assert.equal(r.intent, 'unknown');
  assert.equal(r.confidence, 0);
});

test('extracts datasets, services and people, but not the requester', () => {
  const r = route('Lena Ortiz and Sam Rivera need the pharmacy fills; the lab feed is behind too.', 'lena.ortiz');
  assert.deepEqual(r.entities.datasets, ['pharmacy_fills_deid']);
  assert.deepEqual(r.entities.services, ['lab_feed']);
  assert.deepEqual(r.entities.people, ['sam.rivera']);
});

test('the longest alias wins: "behavioral health notes" is one dataset', () => {
  assert.deepEqual(route('access to behavioral health notes').entities.datasets, ['behavioral_health_notes']);
});

test('phrases match on word boundaries only', () => {
  // "downtown" must not count as "down", "pto" must not match inside "symptoms".
  const r = route('symptoms data for downtown clinics');
  assert.equal(r.scores.incident, 0);
  assert.equal(r.scores.out_of_scope, 0);
});

test('same input, same answer', () => {
  const text = 'need access to encounters, also the dashboard is broken';
  assert.deepEqual(route(text), route(text));
});
