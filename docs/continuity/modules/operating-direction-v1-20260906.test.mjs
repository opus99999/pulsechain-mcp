// Offline document/precondition checks only. No network, activation or worker event.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(dir, 'operating-direction-v1-20260906.md'), 'utf8');
const [roles, spec] = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
let checks = 0;
function check(name, f) { f(); checks++; }
check('all thirteen existing logical roles represented once', () => {
  assert.equal(roles.length, 13);
  assert.equal(new Set(roles.map(r => r.logical_role)).size, 13);
  assert.deepEqual(spec.logical_roles, roles.map(r => r.logical_role));
});
check('exactly six existing tasks; Control Center is a function', () => {
  const tasks = roles.filter(r => r.instance.automation_id);
  assert.equal(tasks.length, 6);
  assert.equal(new Set(tasks.map(r => r.instance.automation_id)).size, 6);
  assert.equal(roles.find(r => r.logical_role === 'control-center-function').instance.separate_instance, false);
});
check('five provider instances with only approved coordinator dual hat', () => {
  const providers = roles.filter(r => r.instance.provider_agent_id);
  assert.equal(providers.length, 6);
  assert.equal(new Set(providers.map(r => r.instance.provider_agent_id)).size, 5);
  assert.equal(providers.find(r => r.logical_role === 'grok-master-chef').instance.provider_agent_id, providers.find(r => r.logical_role === 'grok-x-protocol').instance.provider_agent_id);
});
check('document cannot claim actual activation', () => {
  assert.equal(spec.production_activation_allowed, false);
  assert.equal(spec.classification, 'OFFLINE_PROCEDURE_ONLY');
  assert.equal(spec.missing_native_operations.length, 4);
});
// This evaluates the proposed checklist, never a production authorization.
function gaps(fixture) {
  const names = [...spec.activation_preconditions];
  if (fixture.logical_role === 'chatgpt-worker-5') names.push(spec.worker5_extra);
  return names.filter(k => fixture[k] !== true);
}
const hypothetical = Object.fromEntries(spec.activation_preconditions.map(k => [k, true]));
check('fully supplied hypothetical checklist is internally consistent', () => assert.deepEqual(gaps(hypothetical), []));
for (const key of spec.activation_preconditions) {
  check(`missing ${key} prevents procedural readiness`, () => assert.deepEqual(gaps({...hypothetical, [key]: false}), [key]));
  check(`unavailable ${key} is not treated as satisfied`, () => assert.deepEqual(gaps({...hypothetical, [key]: 'UNAVAILABLE'}), [key]));
}
check('Worker5 needs a verified owner-delivery destination', () => {
  assert.deepEqual(gaps({...hypothetical, logical_role: 'chatgpt-worker-5'}), [spec.worker5_extra]);
  assert.deepEqual(gaps({...hypothetical, logical_role: 'chatgpt-worker-5', [spec.worker5_extra]: true}), []);
});
check('current unknown native controls keep real transfer blocked', () => {
  const current = {scoped_owner_authority: false, actual_successor_identity: 'UNAVAILABLE', predecessor_write_exclusion_verified: 'UNAVAILABLE', task_binding_verified: 'UNAVAILABLE'};
  assert.ok(gaps(current).length > 0);
});
check('old accepted pointers stay separate from current reader checks', () => {
  const pointers = roles.filter(r => r.accepted_pointer);
  assert.equal(pointers.length, 4);
  for (const r of pointers) {
    assert.match(r.accepted_pointer.artifact_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(r.accepted_pointer.manifest_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(r.handover_status, 'PARTIAL_REFERENCE_PACKAGE');
  }
});
console.log(JSON.stringify({checks,passed:checks,scope:'OFFLINE_DOCUMENT_AND_PROCEDURE_ONLY',production_activation:false}));
