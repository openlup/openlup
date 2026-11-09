import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { configurations } from '../owned/store.config.ts';
import { isOperation, operations, type Operation } from '../shared/api.ts';
import { nativeLimits, operationLimits } from '../shared/limits.ts';
import { dispatchAction, pendingBindings, type ActionContext } from '../host/bindings.ts';
import { createApplication } from '../host/server.ts';

const dispositions: Array<[Operation, string]> = [
  ['return.request', 'starter_return_request_unavailable'],
  ['operator.returnApprove', 'starter_return_decision_unavailable'],
  ['operator.returnReject', 'starter_return_decision_unavailable'],
  ['operator.hold', 'starter_order_hold_unavailable'],
  ['operator.release', 'starter_order_hold_unavailable'],
  ['operator.cancelUnpaid', 'starter_order_cancellation_unavailable'],
  ['operator.externalRefund', 'starter_external_refund_mark_unavailable'],
  ['operator.label', 'starter_shipment_mutation_unavailable'],
  ['operator.handoff', 'starter_shipment_mutation_unavailable'],
  ['operator.delivery', 'starter_shipment_mutation_unavailable'],
  ['tracking.read', 'starter_tracking_access_unavailable'],
  ['research.submit', 'host_binding_required'], ['ingest.submit', 'host_binding_required'],
];
const context: ActionContext = { actor: { customerRef: 'customer', operatorRef: 'operator' },
  commandKey: 'named-limit-command-123', config: Object.values(configurations)[0]! };

for (const [operation, code] of dispositions) test(`${operation} refuses before looking up an action`, async () => {
  const bindings = pendingBindings();
  Object.defineProperty(bindings.actions, operation, { get() { throw new Error('deferred_action_touched'); } });
  for (const commandKey of [context.commandKey, context.commandKey, 'changed-command-123456']) {
    assert.deepEqual(await dispatchAction(bindings, operation, { actorUserId: 'forged', requestedBy: 'foreign',
      receipt: { ok: true }, proofGrade: 'delivered', returnRef: 'foreign', orderRef: 'foreign' },
    { ...context, commandKey }), { ok: false, code });
  }
  assert.equal(operationLimits[operation]?.code, code);
  assert.ok(nativeLimits.includes(operationLimits[operation]!));
  assert.ok(Object.isFrozen(operationLimits));
  assert.ok(Object.isFrozen(operationLimits[operation]));
  assert.ok(Object.isFrozen(operationLimits[operation]!.explanation));
});

test('actor admission precedes the named refusal and ignores body identities and receipts', async () => {
  for (const [operation] of dispositions) {
    const required = operation.startsWith('operator.') || operation === 'ingest.submit' ? 'operator_required'
      : ['return.request', 'subscription.command'].includes(operation) ? 'customer_session_required' : undefined;
    if (!required) continue;
    assert.deepEqual(await dispatchAction(pendingBindings(), operation, { operatorRef: 'operator', customerRef: 'customer',
      actorUserId: 'operator', principalRef: 'customer', receipt: { admitted: true } },
    { ...context, actor: { customerRef: null, operatorRef: null } }), { ok: false, code: required });
  }
});

test('the removed reader retains the HTTP 404 protocol', async () => {
  assert.equal(isOperation('operator.returns'), false);
  assert.equal(operations.length, 51);
  const bindings = pendingBindings();
  bindings.authenticate = async () => { throw new Error('removed_reader_authenticated'); };
  const server = createApplication(bindings).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await new Promise<{ status: number; value: unknown }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path: '/api/actions/operator.returns', method: 'POST',
        headers: { Host: '127.0.0.1:4319', Origin: 'http://127.0.0.1:4319', 'X-Starter-Request': '1', 'Content-Type': 'application/json' } }, res => {
        let body = '';
        res.on('data', chunk => { body += String(chunk); });
        res.on('end', () => resolve({ status: res.statusCode!, value: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.deepEqual(response, { status: 404, value: { ok: false, code: 'starter_operation_unknown' } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
