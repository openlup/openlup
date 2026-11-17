import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDunningLadderExhausted, nextRetryAttemptAt } from '@openlup/core/subscription';
import { renewalPolicy, type RenewalPolicyInput } from '../owned/renewal-policy.ts';

test('default renewal policy does not read dependencies or perform any effect', async () => {
  const input = new Proxy({} as RenewalPolicyInput, { get() { throw new Error('default_policy_dependency_access'); } });
  assert.equal(await renewalPolicy(input), undefined);
});

test('example exhaustion decision uses the same 1/3/7 day backoffs as failure recording', () => {
  const cadence = { backoffHours: [24, 72, 168] };
  let at = '2000-01-01T00:00:00.000Z';
  for (const retryAttempt of [1, 2, 3, 4]) {
    const nextRetryAt = nextRetryAttemptAt(at, retryAttempt, cadence);
    const status = nextRetryAt ? 'retry_scheduled' : 'payment_failed';
    assert.equal(isDunningLadderExhausted({ status, retryAttempt, nextRetryAt }, cadence), retryAttempt === 4);
    if (nextRetryAt) {
      assert.equal(Date.parse(nextRetryAt) - Date.parse(at), cadence.backoffHours[retryAttempt - 1]! * 3600_000);
      at = nextRetryAt;
    }
  }
  // Early class termination and successful recovery are not exhaustion.
  assert.equal(isDunningLadderExhausted({ status: 'payment_failed', retryAttempt: 1, nextRetryAt: null }, cadence), false);
  assert.equal(isDunningLadderExhausted({ status: 'paid', retryAttempt: 4, nextRetryAt: null }, cadence), false);
});
