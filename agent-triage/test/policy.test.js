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

test('restricted data goes to its named owner, not an automatic denial', () => {
  for (const u of ['priya.raman', 'marcus.lee', 'dana.whitfield', 'theo.nguyen']) {
    const p = decide(u, 'behavioral_health_notes');
    assert.equal(p.decision, 'owner_approval', u);
    assert.equal(p.rule, 'R4-restricted-owner');
    assert.deepEqual(p.approver, { id: 'ruth.adeyemi', name: 'Dr. Ruth Adeyemi', title: 'Behavioral Health data owner' });
  }
});

test('restricted data still needs an active account and the training first', () => {
  assert.equal(decide('sam.rivera', 'behavioral_health_notes').rule, 'R1-active-user');
  const untrained = { ...D.people['priya.raman'], training: [] };
  assert.equal(AT.policy.evaluate(untrained, D.datasets.behavioral_health_notes).rule, 'R2-training');
});

test('restricted data with no owner on record fails closed', () => {
  const orphan = { ...D.datasets.behavioral_health_notes, owner: undefined };
  const p = AT.policy.evaluate(D.people['priya.raman'], orphan);
  assert.equal(p.decision, 'deny');
  assert.equal(p.rule, 'R3-restricted-no-approver');
  assert.equal(p.approver, undefined);
});

test("an owner can't approve their own access", () => {
  const p = decide('ruth.adeyemi', 'behavioral_health_notes');
  assert.equal(p.decision, 'deny');
  assert.equal(p.rule, 'R3-restricted-no-approver');
});

test('account that has not started yet is denied', () => {
  assert.equal(decide('sam.rivera', 'claims_deid_monthly').rule, 'R1-active-user');
});

test('role not on the dataset is denied', () => {
  const p = decide('dana.whitfield', 'claims_deid_monthly');
  assert.equal(p.decision, 'deny');
  assert.equal(p.rule, 'R5-role');
  assert.match(p.reason, /contractor/);
});

test('missing training is denied and names the module', () => {
  const user = { ...D.people['priya.raman'], training: [] };
  const p = AT.policy.evaluate(user, D.datasets.claims_deid_monthly);
  assert.equal(p.rule, 'R2-training');
  assert.match(p.reason, /hipaa_basics/);
});

test('identified data needs an IRB project, and then still needs approval', () => {
  const noProject = { ...D.people['marcus.lee'], projects: [] };
  assert.equal(AT.policy.evaluate(noProject, D.datasets.patient_identified_ehr).rule, 'R6-agreement-project');
  const p = decide('marcus.lee', 'patient_identified_ehr');
  assert.equal(p.decision, 'approval');
  assert.equal(p.risk, 'high');
});

test('limited data set needs a data use agreement', () => {
  const noDua = { ...D.people['marcus.lee'], agreements: [] };
  assert.equal(AT.policy.evaluate(noDua, D.datasets.encounters_limited).rule, 'R6-agreement-project');
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
