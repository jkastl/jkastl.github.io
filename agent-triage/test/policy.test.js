const test = require('node:test');
const assert = require('node:assert/strict');
const AT = require('./load.js');

const D = AT.data;
const decide = (user, ds) => AT.policy.evaluate(D.people[user], D.datasets[ds]);

test('analyst with training gets de-identified data automatically', () => {
  const p = decide('priya.raman', 'claims_deid_monthly');
  assert.equal(p.decision, 'allow');
  assert.equal(p.rule, 'R8-default-allow');
  assert.equal(p.risk, 'low');
});

test('restricted data is denied for everyone, first, by R1', () => {
  for (const u of Object.keys(D.people)) {
    const p = decide(u, 'behavioral_health_notes');
    assert.equal(p.decision, 'deny');
    assert.equal(p.rule, 'R1-restricted');
  }
});

test('account that has not started yet is denied', () => {
  assert.equal(decide('sam.rivera', 'claims_deid_monthly').rule, 'R2-active-user');
});

test('role not on the dataset is denied', () => {
  const p = decide('dana.whitfield', 'claims_deid_monthly');
  assert.equal(p.decision, 'deny');
  assert.equal(p.rule, 'R3-role');
  assert.match(p.reason, /contractor/);
});

test('missing training is denied and names the module', () => {
  const user = { ...D.people['priya.raman'], training: [] };
  const p = AT.policy.evaluate(user, D.datasets.claims_deid_monthly);
  assert.equal(p.rule, 'R4-training');
  assert.match(p.reason, /hipaa_basics/);
});

test('identified data needs an IRB project, and then still needs approval', () => {
  const noProject = { ...D.people['marcus.lee'], projects: [] };
  assert.equal(AT.policy.evaluate(noProject, D.datasets.patient_identified_ehr).rule, 'R6-project');
  const p = decide('marcus.lee', 'patient_identified_ehr');
  assert.equal(p.decision, 'approval');
  assert.equal(p.risk, 'high');
});

test('limited data set needs a data use agreement', () => {
  const noDua = { ...D.people['marcus.lee'], agreements: [] };
  assert.equal(AT.policy.evaluate(noDua, D.datasets.encounters_limited).rule, 'R5-agreement');
});

test('internal data is open to every active role', () => {
  for (const u of ['priya.raman', 'dana.whitfield', 'theo.nguyen', 'lena.ortiz']) {
    assert.equal(decide(u, 'provider_directory').decision, 'allow', u);
  }
});

test('unknown user or dataset is denied, not thrown', () => {
  assert.equal(AT.policy.evaluate(undefined, D.datasets.claims_deid_monthly).decision, 'deny');
  assert.equal(AT.policy.evaluate(D.people['priya.raman'], undefined).decision, 'deny');
});
